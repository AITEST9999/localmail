import nodemailer, { type SendMailOptions } from 'nodemailer';

import {
  HopLimitExceededError,
  nextHopCount,
  normalizeSubject,
  type InboundIngestor,
  type MessageEventPublisher,
  type ObjectStore,
  type StoredAttachment,
} from '@localmail/core';
import { createId } from '@localmail/db';

import type {
  ApiStore,
  InboxRow,
  MessageRow,
  PersistOutboundMessage,
} from './store.js';

export interface OutboundMail {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string | null;
  html: string | null;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  hopCount: number;
  date: Date;
  attachments: OutboundAttachment[];
  dkim?: { domainName: string; keySelector: string; privateKey: string };
}

export interface OutboundAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutboundTransport {
  build(mail: OutboundMail): Promise<Buffer>;
  sendRaw(raw: Buffer, envelopeFrom: string, recipients: string[]): Promise<void>;
  close?(): void;
}

export interface SendOutboundInput {
  sender: InboxRow;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string | null;
  html?: string | null;
  labels?: string[];
  existingThreadId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  incomingHopCount?: number | null;
  attachments?: OutboundAttachment[];
}

export interface OutboundMessageService {
  send(input: SendOutboundInput): Promise<MessageRow>;
}

export interface OutboundStore {
  findLocalInboxesByAddresses: ApiStore['findLocalInboxesByAddresses'];
  persistOutboundMessage(
    message: PersistOutboundMessage,
  ): Promise<MessageRow>;
}

export interface CreateOutboundMessageServiceOptions {
  store: OutboundStore;
  objectStore: ObjectStore;
  ingestor: InboundIngestor;
  transport: OutboundTransport;
  mailDomain: string;
  maximumHopCount: number;
  eventPublisher: MessageEventPublisher;
  dkimResolver?: (sender: InboxRow) => Promise<OutboundMail['dkim'] | undefined>;
  now?: () => Date;
}

export function createOutboundMessageService({
  store,
  objectStore,
  ingestor,
  transport,
  mailDomain,
  maximumHopCount,
  eventPublisher,
  dkimResolver,
  now = () => new Date(),
}: CreateOutboundMessageServiceOptions): OutboundMessageService {
  return {
    async send(input) {
      const hopCount = nextHopCount(input.incomingHopCount, maximumHopCount);
      const sentAt = now();
      const id = createId('msg');
      const newThreadId = createId('thr');
      const messageIdHeader = `<${id}@${mailDomain}>`;
      const to = normalizeAddresses(input.to);
      const cc = normalizeAddresses(input.cc ?? []);
      const bcc = normalizeAddresses(input.bcc ?? []);
      const recipients = [...new Set([...to, ...cc, ...bcc])];
      const labels = [...new Set(['sent', ...(input.labels ?? [])])];
      const outboundAttachments = input.attachments ?? [];
      const mail: OutboundMail = {
        from: input.sender.address,
        to,
        cc,
        bcc,
        // API JSON strings are decoded Unicode. Nodemailer performs RFC 2047
        // encoding only at the transport boundary; threading sees this value.
        subject: input.subject,
        text: input.text ?? null,
        html: input.html ?? null,
        messageId: messageIdHeader,
        inReplyTo: input.inReplyTo ?? null,
        references: input.references ?? [],
        hopCount,
        date: sentAt,
        attachments: outboundAttachments,
      };
      if (dkimResolver) mail.dkim = await dkimResolver(input.sender);
      const raw = await transport.build(mail);
      const rawObjectKey = `raw/${input.sender.id}/${id}.eml`;
      const uploadedKeys: string[] = [];
      const storedAttachments: StoredAttachment[] = [];
      let persisted: MessageRow;
      try {
        await objectStore.put(rawObjectKey, raw, 'message/rfc822');
        uploadedKeys.push(rawObjectKey);
        for (const attachment of outboundAttachments) {
          const attachmentId = createId('att');
          const objectKey = `attachments/${input.sender.id}/${id}/${attachmentId}-${sanitizeFilename(attachment.filename)}`;
          await objectStore.put(
            objectKey,
            attachment.content,
            attachment.contentType,
          );
          uploadedKeys.push(objectKey);
          storedAttachments.push({
            id: attachmentId,
            filename: attachment.filename,
            contentType: attachment.contentType,
            size: attachment.content.byteLength,
            objectKey,
            contentId: null,
          });
        }
        persisted = await store.persistOutboundMessage({
          id,
          inboxId: input.sender.id,
          existingThreadId: input.existingThreadId ?? null,
          newThreadId,
          messageIdHeader,
          inReplyTo: mail.inReplyTo,
          references: mail.references,
          from: mail.from,
          to,
          cc,
          bcc,
          subject: mail.subject,
          subjectNormalized: normalizeSubject(mail.subject),
          text: mail.text,
          html: mail.html,
          labels,
          rawObjectKey,
          sizeBytes: raw.byteLength,
          hopCount,
          sentAt,
          preview: makePreview(mail.text, mail.html),
          attachments: storedAttachments,
        });
      } catch (error) {
        await Promise.allSettled(
          uploadedKeys.map((objectKey) => objectStore.delete(objectKey)),
        );
        throw error;
      }

      await eventPublisher.emit({
        type: 'message.sent',
        podId: input.sender.podId,
        inboxId: input.sender.id,
        threadId: persisted.threadId,
        messageId: persisted.id,
      });

      const localInboxes = await store.findLocalInboxesByAddresses(recipients);
      const localAddresses = new Set(
        localInboxes.map((inbox) => inbox.address.toLowerCase()),
      );
      for (const inbox of localInboxes) await ingestor.ingest(raw, inbox);

      const externalRecipients = recipients.filter(
        (address) => !localAddresses.has(address),
      );
      if (externalRecipients.length > 0)
        await transport.sendRaw(raw, input.sender.address, externalRecipients);

      return persisted;
    },
  };
}

export function createNodemailerOutboundTransport(options: {
  host: string;
  port: number;
}): OutboundTransport {
  const composer = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'windows',
  });
  const smtp = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: false,
  });

  return {
    async build(mail) {
      const info = await composer.sendMail(toNodemailerOptions(mail));
      if (!Buffer.isBuffer(info.message))
        throw new Error('Nodemailer stream transport did not return a buffer.');
      return info.message;
    },
    async sendRaw(raw, envelopeFrom, recipients) {
      await smtp.sendMail({
        envelope: { from: envelopeFrom, to: recipients },
        raw,
      });
    },
    close() {
      smtp.close();
    },
  };
}

export { HopLimitExceededError };

function toNodemailerOptions(mail: OutboundMail): SendMailOptions {
  return {
    from: mail.from,
    to: mail.to,
    cc: mail.cc,
    bcc: mail.bcc,
    subject: mail.subject,
    text: mail.text ?? undefined,
    html: mail.html ?? undefined,
    messageId: mail.messageId,
    inReplyTo: mail.inReplyTo ?? undefined,
    references: mail.references,
    date: mail.date,
    headers: { 'X-LocalMail-Hop-Count': String(mail.hopCount) },
    attachments: mail.attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: attachment.content,
    })),
    ...(mail.dkim ? { dkim: mail.dkim } : {}),
  };
}

function normalizeAddresses(addresses: string[]): string[] {
  return [...new Set(addresses.map((address) => address.trim().toLowerCase()))];
}

function makePreview(text: string | null, html: string | null): string | null {
  const content = text ?? html?.replaceAll(/<[^>]*>/g, ' ') ?? '';
  const normalized = content.replaceAll(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized.slice(0, 200) : null;
}

function sanitizeFilename(value: string): string {
  const sanitized = value.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized.length > 0 ? sanitized.slice(0, 180) : 'attachment.bin';
}
