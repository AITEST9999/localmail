import { eq } from 'drizzle-orm';

import {
  CLASSIFY_SKIP_LABEL,
  shouldSkipClassify,
  type MessageEventPublisher,
} from '@localmail/core';
import {
  createId,
  inboxes,
  jevDecisions,
  messages,
  threads,
  type Database,
} from '@localmail/db';
import { classify, type ClassifyOptions } from '@localmail/jev';

export interface ProcessJevClassifyInput {
  messageId: string;
  db: Database;
  eventPublisher: MessageEventPublisher;
  classifyOptions: ClassifyOptions;
}

export type JevClassifyOutcome =
  | { status: 'skipped'; reason: 'missing' | 'skip_classify' }
  | { status: 'classified'; labels: string[]; source: 'jev' | 'rules' };

/**
 * Load message → skip if `skip_classify` → classify → persist decision →
 * union labels → emit `message.labeled`.
 */
export async function processJevClassify(
  input: ProcessJevClassifyInput,
): Promise<JevClassifyOutcome> {
  const [row] = await input.db
    .select({
      id: messages.id,
      inboxId: messages.inboxId,
      threadId: messages.threadId,
      from: messages.from,
      subject: messages.subject,
      text: messages.text,
      extractedText: messages.extractedText,
      labels: messages.labels,
      podId: inboxes.podId,
    })
    .from(messages)
    .innerJoin(inboxes, eq(messages.inboxId, inboxes.id))
    .where(eq(messages.id, input.messageId))
    .limit(1);

  if (!row) return { status: 'skipped', reason: 'missing' };
  if (shouldSkipClassify(row.labels) || row.labels.includes(CLASSIFY_SKIP_LABEL)) {
    return { status: 'skipped', reason: 'skip_classify' };
  }

  const result = await classify(
    {
      from: row.from,
      subject: row.subject,
      extractedText: row.extractedText,
      text: row.text,
    },
    input.classifyOptions,
  );

  const mergedLabels = unionLabels(row.labels, result.labels);

  await input.db.transaction(async (tx) => {
    await tx.insert(jevDecisions).values({
      id: createId('jdec'),
      messageId: row.id,
      answers: result.answers as unknown as Record<string, unknown>,
      latencyMs: result.latencyMs,
    });

    await tx
      .update(messages)
      .set({ labels: mergedLabels })
      .where(eq(messages.id, row.id));

    const [thread] = await tx
      .select({ labels: threads.labels })
      .from(threads)
      .where(eq(threads.id, row.threadId))
      .limit(1);
    if (thread) {
      await tx
        .update(threads)
        .set({ labels: unionLabels(thread.labels, result.labels) })
        .where(eq(threads.id, row.threadId));
    }
  });

  await input.eventPublisher.emit({
    type: 'message.labeled',
    podId: row.podId,
    inboxId: row.inboxId,
    threadId: row.threadId,
    messageId: row.id,
    labels: mergedLabels,
  });

  return {
    status: 'classified',
    labels: mergedLabels,
    source: result.answers.source,
  };
}

function unionLabels(current: string[], incoming: string[]): string[] {
  return [...new Set([...current, ...incoming])];
}
