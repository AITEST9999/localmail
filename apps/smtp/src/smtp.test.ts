import { Readable } from 'node:stream';

import type {
  SMTPServer,
  SMTPServerAddress,
  SMTPServerDataStream,
  SMTPServerSession,
} from 'smtp-server';
import { describe, expect, it } from 'vitest';

import type { ThreadLookupQuery } from '@localmail/core';

import type {
  InboxRecipient,
  InboundRepository,
  MessageEvent,
  ObjectStore,
  PersistInboundMessage,
} from './contracts.js';
import { createInboundIngestor } from './ingest.js';
import { createLocalMailSmtpServer } from './smtp-server.js';

const inbox: InboxRecipient = {
  id: 'inb_test',
  podId: 'pod_test',
  address: 'agent@localmail.test',
};

describe('inbound ingestion', () => {
  it('parses, stores, threads, persists, and emits an inbound message', async () => {
    const objects = new Map<string, { body: Buffer; contentType: string }>();
    const lookups: Array<{ inboxId: string; query: ThreadLookupQuery }> = [];
    const persisted: PersistInboundMessage[] = [];
    const events: MessageEvent[] = [];
    const repository = makeRepository({ lookups, persisted });
    const objectStore: ObjectStore = {
      put(key, body, contentType) {
        objects.set(key, { body, contentType });
        return Promise.resolve();
      },
      delete(key) {
        objects.delete(key);
        return Promise.resolve();
      },
    };
    const ingestor = createInboundIngestor({
      mailDomain: 'localmail.test',
      repository,
      objectStore,
      eventPublisher: {
        emit(event) {
          events.push(event);
        },
      },
      now: () => new Date('2026-09-23T12:00:00.000Z'),
    });
    const raw = Buffer.from(
      [
        'From: Sender <sender@example.com>',
        'To: Agent <agent@localmail.test>',
        'Subject: Re: Project update',
        'Message-ID: <new@example.com>',
        'In-Reply-To: <parent@example.com>',
        'References: <root@example.com> <parent@example.com>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="test-boundary"',
        '',
        '--test-boundary',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'The parsed body.',
        '--test-boundary',
        'Content-Type: text/plain; name="note.txt"',
        'Content-Disposition: attachment; filename="note.txt"',
        'Content-Transfer-Encoding: base64',
        '',
        'YXR0YWNobWVudCBib2R5',
        '--test-boundary--',
        '',
      ].join('\r\n'),
    );

    const result = await ingestor.ingest(raw, inbox);

    expect(result.messageId).toMatch(/^msg_/);
    expect(result.threadId).toMatch(/^thr_/);
    expect(lookups).toEqual([
      {
        inboxId: inbox.id,
        query: {
          kind: 'message-ids',
          messageIds: [
            '<new@example.com>',
            '<parent@example.com>',
            '<root@example.com>',
          ],
        },
      },
      {
        inboxId: inbox.id,
        query: { kind: 'subject', normalizedSubject: 'project update' },
      },
    ]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      inbox,
      messageIdHeader: '<new@example.com>',
      labels: ['inbox', 'unread'],
      subjectNormalized: 'project update',
      text: 'The parsed body.',
      attachments: [
        { filename: 'note.txt', contentType: 'text/plain', size: 15 },
      ],
    });
    expect([...objects.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: raw, contentType: 'message/rfc822' }),
        expect.objectContaining({
          body: Buffer.from('attachment body'),
          contentType: 'text/plain',
        }),
      ]),
    );
    expect(events).toEqual([
      {
        type: 'message.received',
        podId: inbox.podId,
        inboxId: inbox.id,
        threadId: result.threadId,
        messageId: result.messageId,
      },
    ]);
  });

  it('removes uploaded objects when database persistence fails', async () => {
    const uploaded = new Set<string>();
    const deleted: string[] = [];
    const repository = makeRepository();
    repository.persistMessage = () => Promise.reject(new Error('db unavailable'));
    const ingestor = createInboundIngestor({
      mailDomain: 'localmail.test',
      repository,
      objectStore: {
        put(key) {
          uploaded.add(key);
          return Promise.resolve();
        },
        delete(key) {
          deleted.push(key);
          uploaded.delete(key);
          return Promise.resolve();
        },
      },
      eventPublisher: { emit: () => undefined },
    });

    await expect(
      ingestor.ingest(
        Buffer.from(
          'From: sender@example.com\r\nTo: agent@localmail.test\r\n\r\nBody',
        ),
        inbox,
      ),
    ).rejects.toThrow('db unavailable');
    expect(uploaded.size).toBe(0);
    expect(deleted).toHaveLength(1);
  });
});

describe('SMTP protocol', () => {
  it('rejects an unknown recipient with 550 in onRcptTo', async () => {
    let ingestCount = 0;
    const server = createLocalMailSmtpServer({
      directory: { findByAddress: () => Promise.resolve(null) },
      policy: { evaluate: () => ({ allowed: true }) },
      ingestor: {
        ingest: () => {
          ingestCount += 1;
          return Promise.resolve({ messageId: 'msg_test', threadId: 'thr_test' });
        },
      },
    });
    const error = await callRcptTo(
      server,
      'missing@localmail.test',
    );

    expect(error?.message).toContain('Mailbox unavailable');
    expect((error as Error & { responseCode?: number }).responseCode).toBe(550);
    expect(ingestCount).toBe(0);
  });

  it('accepts DATA for a known, policy-allowed recipient', async () => {
    const ingested: Array<{ raw: Buffer; inbox: InboxRecipient }> = [];
    const server = createLocalMailSmtpServer({
      directory: {
        findByAddress: (address) =>
          Promise.resolve(address === inbox.address ? inbox : null),
      },
      policy: { evaluate: () => ({ allowed: true }) },
      ingestor: {
        ingest(raw, recipient) {
          ingested.push({ raw, inbox: recipient });
          return Promise.resolve({ messageId: 'msg_test', threadId: 'thr_test' });
        },
      },
    });
    const recipientError = await callRcptTo(
      server,
      inbox.address,
    );
    const raw = Buffer.from(
      'From: sender@example.com\r\nTo: agent@localmail.test\r\nMessage-ID: <socket@example.com>\r\n\r\nHello',
    );
    const dataError = await callData(server, raw);

    expect(recipientError).toBeNull();
    expect(dataError).toBeNull();
    expect(ingested).toEqual([{ raw, inbox }]);
  });

  it('rejects a blocked sender in drop mode without ingesting', async () => {
    let ingestCount = 0;
    const server = createLocalMailSmtpServer({
      directory: {
        findByAddress: (address) =>
          Promise.resolve(address === inbox.address ? inbox : null),
      },
      policy: {
        evaluate: () => ({
          allowed: false,
          reason: 'Sender blocked by rule r_test',
        }),
      },
      ingestor: {
        ingest: () => {
          ingestCount += 1;
          return Promise.resolve({ messageId: 'msg_x', threadId: 'thr_x' });
        },
      },
    });
    const error = await callRcptTo(server, inbox.address);
    expect(error?.message).toContain('Sender blocked');
    expect((error as Error & { responseCode?: number }).responseCode).toBe(550);
    expect(ingestCount).toBe(0);
  });

  it('passes spam-mode ingest overrides through to the ingestor', async () => {
    const ingested: Array<{
      inbox: InboxRecipient;
      options?: { labels?: string[]; skipClassify?: boolean };
    }> = [];
    const server = createLocalMailSmtpServer({
      directory: {
        findByAddress: (address) =>
          Promise.resolve(address === inbox.address ? inbox : null),
      },
      policy: {
        evaluate: () => ({
          allowed: true,
          ingest: {
            labels: ['spam', 'unread', 'skip_classify'],
            skipClassify: true,
          },
        }),
      },
      ingestor: {
        ingest(_raw, recipient, options) {
          ingested.push({ inbox: recipient, options });
          return Promise.resolve({ messageId: 'msg_spam', threadId: 'thr_spam' });
        },
      },
    });
    const recipientError = await callRcptTo(server, inbox.address);
    const dataError = await callData(
      server,
      Buffer.from(
        'From: bot@spam.com\r\nTo: agent@localmail.test\r\nMessage-ID: <spam@example.com>\r\n\r\nNo',
      ),
    );
    expect(recipientError).toBeNull();
    expect(dataError).toBeNull();
    expect(ingested).toEqual([
      {
        inbox,
        options: {
          labels: ['spam', 'unread', 'skip_classify'],
          skipClassify: true,
        },
      },
    ]);
  });
});

describe('inbound spam-label mode', () => {
  it('persists spam + skip_classify and sets skipClassify for future Jev', async () => {
    const persisted: PersistInboundMessage[] = [];
    const repository = makeRepository({ persisted });
    const ingestor = createInboundIngestor({
      mailDomain: 'localmail.test',
      repository,
      objectStore: {
        put: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      },
      eventPublisher: { emit: () => undefined },
    });

    await ingestor.ingest(
      Buffer.from(
        'From: bot@spam.com\r\nTo: agent@localmail.test\r\nSubject: junk\r\nMessage-ID: <spam-persist@example.com>\r\n\r\nNope',
      ),
      inbox,
      {
        labels: ['spam', 'unread', 'skip_classify'],
        skipClassify: true,
      },
    );

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.labels).toEqual(['spam', 'unread', 'skip_classify']);
    expect(persisted[0]?.skipClassify).toBe(true);
    // Future jev-classify must honor this durable signal (label + flag).
    expect(persisted[0]?.labels.includes('skip_classify')).toBe(true);
  });
});

function makeRepository(
  captures: {
    lookups?: Array<{ inboxId: string; query: ThreadLookupQuery }>;
    persisted?: PersistInboundMessage[];
  } = {},
): InboundRepository {
  return {
    findByAddress: () => Promise.resolve(inbox),
    lookupThread(inboxId, query) {
      captures.lookups?.push({ inboxId, query });
      return Promise.resolve(null);
    },
    persistMessage(message) {
      captures.persisted?.push(message);
      return Promise.resolve({
        messageId: message.id,
        threadId: message.existingThread?.id ?? message.newThreadId,
      });
    },
  };
}

function makeSession(): SMTPServerSession {
  return {
    id: 'session_test',
    remoteAddress: '127.0.0.1',
    envelope: {
      mailFrom: { address: 'sender@example.com', args: {} },
      rcptTo: [],
    },
  } as unknown as SMTPServerSession;
}

async function callRcptTo(
  server: SMTPServer,
  address: string,
): Promise<Error | null> {
  if (!server.options.onRcptTo) throw new Error('onRcptTo handler missing');
  const session = makeSession();
  return new Promise((resolve) => {
    server.options.onRcptTo?.(
      { address, args: {} } satisfies SMTPServerAddress,
      session,
      (error) => resolve(error ?? null),
    );
  });
}

async function callData(
  server: SMTPServer,
  raw: Buffer,
): Promise<Error | null> {
  if (!server.options.onData) throw new Error('onData handler missing');
  const session = makeSession();
  return new Promise((resolve) => {
    server.options.onData?.(
      Readable.from(raw) as SMTPServerDataStream,
      session,
      (error) => resolve(error ?? null),
    );
  });
}
