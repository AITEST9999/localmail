import { migrate } from 'drizzle-orm/postgres-js/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabase } from './client.js';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const { db, close } = createDatabase(url);
  const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
  console.log(`Running migrations from ${migrationsFolder}…`);
  await migrate(db, { migrationsFolder });
  console.log('Migrations complete.');
  await close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
