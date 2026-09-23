import { loadEnv } from '@localmail/config';

import { createSmtpRuntime } from './runtime.js';

const env = loadEnv();
const runtime = createSmtpRuntime(env);

runtime.server.on('error', (error) => {
  console.error('LocalMail SMTP server error', error);
});

runtime.server.listen(env.SMTP_INBOUND_PORT, '0.0.0.0', () => {
  console.log(
    `LocalMail inbound SMTP listening on 0.0.0.0:${env.SMTP_INBOUND_PORT}`,
  );
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await runtime.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
