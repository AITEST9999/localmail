import { asc, eq, isNull } from 'drizzle-orm';
import { loadEnv } from '@localmail/config';
import { createDatabase, messages } from '@localmail/db';
import { embed } from '@localmail/embeddings';

export async function backfillEmbeddings(batchSize = 100): Promise<number> {
  const env = loadEnv();
  const database = createDatabase(env.DATABASE_URL);
  let total = 0;
  try {
    while (true) {
      const rows = await database.db.select({ id: messages.id, subject: messages.subject, text: messages.text, extractedText: messages.extractedText })
        .from(messages).where(isNull(messages.embedding)).orderBy(asc(messages.id)).limit(batchSize);
      if (rows.length === 0) break;
      for (const row of rows) {
        const vector = await embed([row.subject ?? '', row.text ?? '', row.extractedText ?? ''].filter(Boolean).join('\n'));
        await database.db.update(messages).set({ embedding: vector }).where(eq(messages.id, row.id));
        total += 1;
      }
    }
    return total;
  } finally {
    await database.close();
  }
}

if (process.argv[1]?.endsWith('backfill-embeddings.ts')) {
  backfillEmbeddings().then((count) => console.log(`backfilled ${count} message embeddings`)).catch((error) => { console.error(error); process.exitCode = 1; });
}
