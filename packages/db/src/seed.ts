import { randomBytes, scryptSync } from 'node:crypto';

import { loadEnv } from '@localmail/config';

import { createDatabase } from './client.js';
import { createId } from './id.js';
import { apiKeys, inboxes, pods } from './schema.js';

function hashApiKey(apiKey: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(apiKey, salt, 64);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

async function seed(): Promise<void> {
  const env = loadEnv();
  const { db, close } = createDatabase(env.DATABASE_URL);
  const podId = 'pod_local_dev';

  try {
    await db
      .insert(pods)
      .values({ id: podId, name: 'Local Development' })
      .onConflictDoNothing();

    await db
      .insert(apiKeys)
      .values({
        id: createId('key'),
        podId,
        prefix: env.ADMIN_API_KEY.slice(0, 12),
        hash: hashApiKey(env.ADMIN_API_KEY),
        scopes: ['*'],
      })
      .onConflictDoNothing({ target: apiKeys.prefix });

    await db
      .insert(inboxes)
      .values({
        id: 'inb_demo',
        podId,
        username: 'support-bot',
        domain: env.MAIL_DOMAIN,
        address: `support-bot@${env.MAIL_DOMAIN}`,
        displayName: 'Support Bot',
        clientId: 'seed-support-bot',
      })
      .onConflictDoNothing({ target: inboxes.address });

    process.stdout.write(
      'Seeded local pod, hashed admin key, and demo inbox.\n',
    );
  } finally {
    await close();
  }
}

await seed();
