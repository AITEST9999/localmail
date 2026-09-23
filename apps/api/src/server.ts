import { loadEnv } from '@localmail/config';
import { decodeEncryptionKey } from '@localmail/core';

import { createApp } from './app.js';

const env = loadEnv();
if (!env.APP_ENCRYPTION_KEY) {
  throw new Error('APP_ENCRYPTION_KEY is required at API bootstrap.');
}
decodeEncryptionKey(env.APP_ENCRYPTION_KEY);
const app = createApp(env);

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
