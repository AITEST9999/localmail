import { randomUUID } from 'node:crypto';

import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';

import {
  headerString,
  isAutoSubmittedShortCircuit,
} from './auto-submitted.js';
import type {
  InboundRepository,
  InboxRecipient,
  MessageEventPublisher,
  ObjectStore,
  PersistedInboundMessage,
  StoredAttachment,
} from './inbound-contracts.js';
import { normalizeSubject, resolveThread } from './threading.js';

export interface InboundIngestOptions {
  labels?: string[];
  skipClassify?: boolean;
}

export interface InboundIngestor {
  ingest(
    raw: Buffer,
    inbox: InboxRecipient,
    options?: InboundIngestOptions,
  ): Promise<PersistedInboundMessage>;
}

export interface CreateInboundIngestorOptions {
  mailDomain: string;
  repository: InboundRepository;
  objectStore: ObjectStore;
  eventPublisher: MessageEventPublisher;
  now?: () => Date;
}

export function createInboundIngestor({
  mailDomain,
  repository,
  objectStore,
  eventPublisher,
  now = () => new Date(),
}: CreateInboundIngestorOptions): InboundIngestor {
  return {
    async ingest(raw, inbox, options) {
      const parsed = await simpleParser(raw);
      const messageId = createId('msg');
      const newThreadId = createId('thr');
      const messageIdHeader = canonicalMessageId(
        parsed.messageId ?? `${messageId}@${mailDomain}`,
      );
      const inReplyTo = parsed.inReplyTo
        ? canonicalMessageId(parsed.inReplyTo)
        : null;
      const references = normalizeReferences(parsed.references);
      const subject = parsed.subject ?? null;
      const subjectNormalized = normalizeSubject(subject ?? '');
      const receivedAt = now();

      const resolution = await resolveThread(
        { messageId: messageIdHeader, inReplyTo, references, subject },
        (query) => repository.lookupThread(inbox.id, query),
      );

      const uploadedKeys: string[] = [];
      const rawObjectKey = `raw/${inbox.id}/${messageId}.eml`;
      const storedAttachments: StoredAttachment[] = [];
      let persisted: PersistedInboundMessage;
      let autoShortCircuit = false;
      let finalLabels: string[] = ['inbox', 'unread'];

      try {
        await objectStore.put(rawObjectKey, raw, 'message/rfc822');
        uploadedKeys.push(rawObjectKey);

        for (const attachment of parsed.attachments) {
          const attachmentId = createId('att');
          const filename = attachment.filename ?? 'attachment.bin';
          const objectKey = `attachments/${inbox.id}/${messageId}/${attachmentId}-${sanitizeFilename(filename)}`;
          await objectStore.put(
            objectKey,
            attachment.content,
            attachment.contentType,
          );
          uploadedKeys.push(objectKey);
          storedAttachments.push({
            id: attachmentId,
            filename,
            contentType: attachment.contentType,
            size: attachment.size,
            objectKey,
            contentId: attachment.contentId ?? null,
          });
        }

        const text = parsed.text ?? null;
        const autoSubmitted = headerString(
          parsed.headers.get('auto-submitted'),
        );
        autoShortCircuit = isAutoSubmittedShortCircuit(autoSubmitted);
        // P3-17: Auto-Submitted short-circuit before Jev — label `auto`, skip classify.
        const baseLabels = options?.labels ?? ['inbox', 'unread'];
        finalLabels = autoShortCircuit
          ? unionLabels(baseLabels, ['auto'])
          : baseLabels;
        const skipClassify =
          options?.skipClassify === true || autoShortCircuit;
        persisted = await repository.persistMessage({
          id: messageId,
          inbox,
          existingThread: resolution.thread,
          newThreadId,
          messageIdHeader,
          inReplyTo,
          references,
          from: parsed.from?.text ?? '',
          to: addressTexts(parsed.to),
          cc: addressTexts(parsed.cc),
          bcc: addressTexts(parsed.bcc),
          subject,
          subjectNormalized,
          text,
          html: parsed.html || null,
          extractedText: text,
          preview: makePreview(parsed),
          labels: finalLabels,
          skipClassify,
          rawObjectKey,
          sizeBytes: raw.byteLength,
          hopCount: parseHopCount(parsed.headers.get('x-localmail-hop-count')),
          sentAt: parsed.date ?? null,
          receivedAt,
          attachments: storedAttachments,
        });
      } catch (error) {
        await Promise.allSettled(
          uploadedKeys.map((objectKey) => objectStore.delete(objectKey)),
        );
        throw error;
      }

      await eventPublisher.emit({
        type: 'message.received',
        podId: inbox.podId,
        inboxId: inbox.id,
        threadId: persisted.threadId,
        messageId: persisted.messageId,
        suppressAgentTriggers: autoShortCircuit || undefined,
      });
      // Emit labeled for header short-circuit so dashboards still see `auto`
      // without going through jev-classify (which must not run).
      if (autoShortCircuit) {
        await eventPublisher.emit({
          type: 'message.labeled',
          podId: inbox.podId,
          inboxId: inbox.id,
          threadId: persisted.threadId,
          messageId: persisted.messageId,
          labels: finalLabels,
        });
      }
      return persisted;
    },
  };
}

function unionLabels(current: string[], incoming: string[]): string[] {
  return [...new Set([...current, ...incoming])];
}

function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function normalizeReferences(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.flatMap((item) => {
    const matches = [...item.matchAll(/<([^<>\s]+)>/g)];
    if (matches.length > 0)
      return matches.map((match) => canonicalMessageId(match[1] ?? ''));
    return item
      .split(/\s+/)
      .filter(Boolean)
      .map(canonicalMessageId);
  });
}

function canonicalMessageId(value: string): string {
  const normalized = value.trim().replace(/^<|>$/g, '');
  return `<${normalized}>`;
}

function addressTexts(
  value: AddressObject | AddressObject[] | undefined,
): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map((address) => address.text);
}

function makePreview(parsed: ParsedMail): string | null {
  const content = parsed.text ?? (parsed.html ? stripHtml(parsed.html) : '');
  const normalized = content.replaceAll(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized.slice(0, 200) : null;
}

function stripHtml(value: string): string {
  return value.replaceAll(/<[^>]*>/g, ' ');
}

function sanitizeFilename(value: string): string {
  const sanitized = value.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized.length > 0 ? sanitized.slice(0, 180) : 'attachment.bin';
}

function parseHopCount(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value.trim()) : 0;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
