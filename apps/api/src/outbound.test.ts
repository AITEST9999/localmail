import { describe, expect, it } from 'vitest';

import {
  noopMessageEventPublisher,
  type InboxRecipient,
  type ObjectStore,
} from '@localmail/core';

import {
  createOutboundMessageService,
  HopLimitExceededError,
  type OutboundMail,
  type OutboundStore,
  type OutboundTransport,
} from './outbound.js';
import type {
  InboxRow,
  MessageRow,
  PersistOutboundMessage,
} from './store.js';

const senderA = makeInbox('inb_a', 'a@localmail.test');
const senderB = makeInbox('inb_b', 'b@localmail.test');

describe('outbound delivery', () => {
  it('uses direct ingestion and never SMTP for a pure local loopback', async () => {
    const harness = makeHarness([senderB]);

    const message = await harness.service.send({
      sender: senderA,
      to: [senderB.address],
      subject: 'Hello locally',
      text: 'Direct delivery',
    });

    expect(message.direction).toBe('outbound');
    expect(harness.smtpRecipients).toEqual([]);
    expect(harness.loopbacks).toEqual([
      expect.objectContaining({ inbox: recipientFromInbox(senderB) }),
    ]);
    expect(harness.loopbacks[0]?.raw.toString()).toContain(
      'X-LocalMail-Hop-Count: 1',
    );
  });

  it('sends only non-local recipients through SMTP', async () => {
    const harness = makeHarness([senderB]);

    await harness.service.send({
      sender: senderA,
      to: [senderB.address, 'outside@example.com'],
      subject: 'Mixed delivery',
      html: '<p>Hello</p>',
    });

    expect(harness.loopbacks).toHaveLength(1);
    expect(harness.smtpRecipients).toEqual([['outside@example.com']]);
  });

  it('stores outbound attachment objects and persists their metadata', async () => {
    const harness = makeHarness([]);
    const content = Buffer.from('stored attachment');

    await harness.service.send({
      sender: senderA,
      to: ['outside@example.com'],
      subject: 'With attachment',
      text: 'See attached.',
      attachments: [
        { filename: 'report.txt', contentType: 'text/plain', content },
      ],
    });

    const attachmentObject = [...harness.objects.entries()].find(([key]) =>
      key.startsWith('attachments/'),
    );
    expect(attachmentObject?.[1]).toEqual(content);
    expect(harness.persisted[0]?.attachments).toEqual([
      expect.objectContaining({
        filename: 'report.txt',
        contentType: 'text/plain',
        size: content.byteLength,
        objectKey: attachmentObject?.[0],
      }),
    ]);
    expect(harness.builtMails[0]?.attachments).toEqual([
      expect.objectContaining({ filename: 'report.txt', content }),
    ]);
  });

  it('caps a synthetic two-inbox loop at the configured hop limit', async () => {
    // P3-17 DoD: loop without Auto-Submitted still stops via hop guard (D4.3).
    const harness = makeHarness([senderA, senderB], 3);
    let incomingHopCount = 0;

    for (let index = 0; index < 3; index += 1) {
      const sender = index % 2 === 0 ? senderA : senderB;
      const recipient = index % 2 === 0 ? senderB : senderA;
      const message = await harness.service.send({
        sender,
        to: [recipient.address],
        subject: `Auto reply ${index}`,
        text: 'Automated',
        incomingHopCount,
      });
      incomingHopCount = message.hopCount;
      expect(harness.loopbacks.at(-1)?.raw.toString()).not.toMatch(
        /Auto-Submitted:/i,
      );
    }

    await expect(
      harness.service.send({
        sender: senderB,
        to: [senderA.address],
        subject: 'Blocked auto reply',
        text: 'Must not deliver',
        incomingHopCount,
      }),
    ).rejects.toBeInstanceOf(HopLimitExceededError);
    expect(harness.loopbacks).toHaveLength(3);
    expect(harness.smtpRecipients).toEqual([]);
  });
});

function makeHarness(localInboxes: InboxRow[], maximumHopCount = 20) {
  const objects = new Map<string, Buffer>();
  const loopbacks: Array<{ raw: Buffer; inbox: InboxRecipient }> = [];
  const smtpRecipients: string[][] = [];
  const persisted: PersistOutboundMessage[] = [];
  const builtMails: OutboundMail[] = [];
  const objectStore: ObjectStore = {
    put(key, body) {
      objects.set(key, body);
      return Promise.resolve();
    },
    delete(key) {
      objects.delete(key);
      return Promise.resolve();
    },
  };
  const store: OutboundStore = {
    findLocalInboxesByAddresses(addresses) {
      return Promise.resolve(
        localInboxes
          .filter((inbox) => addresses.includes(inbox.address))
          .map(recipientFromInbox),
      );
    },
    persistOutboundMessage(message) {
      persisted.push(message);
      return Promise.resolve(toMessageRow(message));
    },
  };
  const transport: OutboundTransport = {
    build(mail) {
      builtMails.push(mail);
      return Promise.resolve(buildRaw(mail));
    },
    sendRaw(_raw, _from, recipients) {
      smtpRecipients.push(recipients);
      return Promise.resolve();
    },
  };
  const service = createOutboundMessageService({
    store,
    objectStore,
    ingestor: {
      ingest(raw, inbox) {
        loopbacks.push({ raw, inbox });
        return Promise.resolve({
          messageId: `received-${loopbacks.length}`,
          threadId: `received-thread-${loopbacks.length}`,
        });
      },
    },
    transport,
    mailDomain: 'localmail.test',
    maximumHopCount,
    eventPublisher: noopMessageEventPublisher,
    now: () => new Date('2026-09-23T12:00:00.000Z'),
  });
  return {
    service,
    objects,
    loopbacks,
    smtpRecipients,
    persisted,
    builtMails,
  };
}

function buildRaw(mail: OutboundMail): Buffer {
  return Buffer.from(
    [
      `From: ${mail.from}`,
      `To: ${mail.to.join(', ')}`,
      `Subject: ${mail.subject}`,
      `Message-ID: ${mail.messageId}`,
      `X-LocalMail-Hop-Count: ${mail.hopCount}`,
      '',
      mail.text ?? mail.html ?? '',
    ].join('\r\n'),
  );
}

function makeInbox(id: string, address: string): InboxRow {
  const [username = 'agent', domain = 'localmail.test'] = address.split('@');
  return {
    id,
    podId: 'pod_test',
    username,
    domain,
    address,
    displayName: null,
    metadata: {},
    clientId: null,
    createdAt: new Date('2026-09-23T00:00:00.000Z'),
  };
}

function recipientFromInbox(inbox: InboxRow): InboxRecipient {
  return { id: inbox.id, podId: inbox.podId, address: inbox.address };
}

function toMessageRow(message: PersistOutboundMessage): MessageRow {
  return {
    id: message.id,
    inboxId: message.inboxId,
    threadId: message.existingThreadId ?? message.newThreadId,
    messageIdHeader: message.messageIdHeader,
    inReplyTo: message.inReplyTo,
    references: message.references,
    direction: 'outbound',
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.text,
    html: message.html,
    extractedText: message.text,
    labels: message.labels,
    rawObjectKey: message.rawObjectKey,
    sizeBytes: message.sizeBytes,
    hopCount: message.hopCount,
    sentAt: message.sentAt,
    receivedAt: null,
    search: null,
    createdAt: message.sentAt,
  };
}
