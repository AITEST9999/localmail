import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type {
  InboundRepository,
  ThreadLookupQuery,
  ThreadRecord,
} from '@localmail/core';

import type { Database } from './client.js';
import { attachments, inboxes, messages, threads } from './schema.js';

export function createDrizzleInboundRepository(
  db: Database,
): InboundRepository {
  return {
    async findByAddress(address) {
      const [row] = await db
        .select({ id: inboxes.id, podId: inboxes.podId, address: inboxes.address })
        .from(inboxes)
        .where(eq(inboxes.address, address))
        .limit(1);
      return row ?? null;
    },

    async lookupThread(inboxId, query) {
      return lookupInboxThread(db, inboxId, query);
    },

    async persistMessage(message) {
      return db.transaction(async (transaction) => {
        const threadId = message.existingThread?.id ?? message.newThreadId;
        if (message.existingThread) {
          await transaction
            .update(threads)
            .set({
              lastMessageAt: message.receivedAt,
              messageCount: sql`${threads.messageCount} + 1`,
              labels: unionLabels(message.existingThread.labels, message.labels),
              preview: message.preview,
            })
            .where(
              and(
                eq(threads.id, threadId),
                eq(threads.inboxId, message.inbox.id),
              ),
            );
        } else {
          await transaction.insert(threads).values({
            id: threadId,
            inboxId: message.inbox.id,
            subjectNormalized: message.subjectNormalized,
            lastMessageAt: message.receivedAt,
            messageCount: 1,
            labels: message.labels,
            preview: message.preview,
          });
        }

        await transaction.insert(messages).values({
          id: message.id,
          inboxId: message.inbox.id,
          threadId,
          messageIdHeader: message.messageIdHeader,
          inReplyTo: message.inReplyTo,
          references: message.references,
          direction: 'inbound',
          from: message.from,
          to: message.to,
          cc: message.cc,
          bcc: message.bcc,
          subject: message.subject,
          text: message.text,
          html: message.html,
          extractedText: message.extractedText,
          labels: message.labels,
          rawObjectKey: message.rawObjectKey,
          sizeBytes: message.sizeBytes,
          hopCount: message.hopCount,
          sentAt: message.sentAt,
          receivedAt: message.receivedAt,
        });

        if (message.attachments.length > 0) {
          await transaction.insert(attachments).values(
            message.attachments.map((attachment) => ({
              ...attachment,
              messageId: message.id,
            })),
          );
        }
        return { messageId: message.id, threadId };
      });
    },
  };
}

async function lookupInboxThread(
  db: Database,
  inboxId: string,
  query: ThreadLookupQuery,
): Promise<ThreadRecord | null> {
  if (query.kind === 'message-ids') {
    if (query.messageIds.length === 0) return null;
    const rows = await db
      .select({
        messageIdHeader: messages.messageIdHeader,
        id: threads.id,
        labels: threads.labels,
      })
      .from(messages)
      .innerJoin(threads, eq(messages.threadId, threads.id))
      .where(
        and(
          eq(messages.inboxId, inboxId),
          inArray(messages.messageIdHeader, [...query.messageIds]),
        ),
      );
    const byMessageId = new Map(
      rows.map((row) => [row.messageIdHeader, row] as const),
    );
    for (const messageId of query.messageIds) {
      const match = byMessageId.get(messageId);
      if (match) return { id: match.id, labels: match.labels };
    }
    return null;
  }

  const [row] = await db
    .select({ id: threads.id, labels: threads.labels })
    .from(threads)
    .where(
      and(
        eq(threads.inboxId, inboxId),
        eq(threads.subjectNormalized, query.normalizedSubject),
      ),
    )
    .orderBy(desc(threads.lastMessageAt), desc(threads.id))
    .limit(1);
  return row ?? null;
}

function unionLabels(current: string[], incoming: string[]): string[] {
  return [...new Set([...current, ...incoming])];
}
