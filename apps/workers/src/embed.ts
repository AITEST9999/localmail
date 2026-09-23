import { eq } from 'drizzle-orm';
import { embed } from '@localmail/embeddings';
import { messages, type Database } from '@localmail/db';

export async function processEmbedMessage(db: Database, messageId: string): Promise<boolean> {
  const [message] = await db.select({ subject: messages.subject, text: messages.text, extractedText: messages.extractedText })
    .from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!message) return false;
  const vector = await embed([message.subject ?? '', message.text ?? '', message.extractedText ?? ''].filter(Boolean).join('\n'));
  await db.update(messages).set({ embedding: vector }).where(eq(messages.id, messageId));
  return true;
}
